// src/lib/photoAuthenticity.ts
//
// Pure display logic for the photo-authenticity report (C2PA reading + metadata consistency heuristics).
// The report is produced server-side by the `photo-provenance` edge function (action `analyze_authenticity`).
//
// Wording rule enforced here and in the locale files: this is a CONFIDENCE WITH REASONS, never a verdict.
// Nothing in the UI may say a photo is "authentic", "genuine", "fake" or "forged".

export type ConsistencyLevel = 'strong' | 'moderate' | 'weak' | 'insufficient';
export type ReasonEffect = 'supports' | 'weakens' | 'info';
export type C2paStatus = 'not_present' | 'read' | 'unsupported_format' | 'too_large' | 'unavailable' | 'error';

export interface AuthenticityReason {
  code: string;
  effect: ReasonEffect;
  weight: number;
  detail?: Record<string, string | number | boolean>;
}

export interface AuthenticityReport {
  analyzerVersion: string;
  analyzedSha256: string;
  metadata: { format: string; parsedCompletely: boolean; hasExif: boolean; hasXmp: boolean; hasGps: boolean; camera: { make: string | null; model: string | null } | null; software: string | null; exifCapturedAt: string | null };
  c2pa: {
    status: C2paStatus;
    validation: 'valid' | 'invalid' | 'unknown';
    trust: 'trusted' | 'untrusted' | 'not_evaluated';
    problems: string[];
    declaresGeneratedMedia: boolean;
    declaresEdits: boolean;
    signer: { commonName: string | null; issuer: string | null; signedAt: string | null } | null;
  };
  consistency: { kind: 'metadata_consistency'; notAVerdict: true; confidence: number | null; level: ConsistencyLevel; reasons: AuthenticityReason[] };
}

export interface StoredAuthenticity { capture_id: string; analyzer_version: string; analyzed_at: string; report: AuthenticityReport }

const LEVELS: readonly string[] = ['strong', 'moderate', 'weak', 'insufficient'];

/** Defensive parse of the RPC payload: anything malformed is dropped rather than rendered. */
export function parseAuthenticityItems(data: unknown): Map<string, StoredAuthenticity> {
  const out = new Map<string, StoredAuthenticity>();
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    const it = raw as Partial<StoredAuthenticity> | null;
    const r = it?.report;
    if (!it || typeof it.capture_id !== 'string' || !r || typeof r !== 'object') continue;
    const c = r.consistency;
    if (!c || !LEVELS.includes(c.level) || !Array.isArray(c.reasons) || !r.c2pa) continue;
    if ((c.level === 'insufficient') !== (c.confidence === null)) continue; // never show a number for "no data" or vice versa
    out.set(it.capture_id, it as StoredAuthenticity);
  }
  return out;
}

/** Reasons that move the number first (largest absolute weight), information-only last. Stable for equal weights. */
export function orderedReasons(reasons: AuthenticityReason[]): AuthenticityReason[] {
  return reasons
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Math.abs(b.r.weight) - Math.abs(a.r.weight) || a.i - b.i)
    .map((x) => x.r);
}

/** i18n key (inside photoProvenance:authenticity.c2pa.line.*) that describes the C2PA result in plain words. */
export function c2paLineKey(c2pa: AuthenticityReport['c2pa']): string {
  if (c2pa.status !== 'read') return c2pa.status;
  if (c2pa.validation === 'invalid') return 'invalid';
  if (c2pa.validation === 'unknown') return 'unknown';
  if (c2pa.trust === 'trusted') return 'valid_trusted';
  if (c2pa.trust === 'untrusted') return 'valid_untrusted_signer';
  return 'valid_not_evaluated';
}

/** Captures that can still be analysed: sealed, files not erased, no report yet. */
export function capturesToAnalyse(captures: Array<{ id: string; files_erased: boolean }>, existing: Map<string, StoredAuthenticity>, limit = 25): string[] {
  return captures.filter((c) => !c.files_erased && !existing.has(c.id)).slice(0, limit).map((c) => c.id);
}

export function confidenceBarPercent(c: AuthenticityReport['consistency']): number {
  return c.confidence === null ? 0 : Math.max(0, Math.min(100, Math.round(c.confidence)));
}
