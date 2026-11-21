// src/lib/outcomeProof/mappers.ts - database row -> domain type. Pure (no Supabase import) so it is unit-testable.
import type { CostBasis, Exclusion, ProofCase, ProofConsent, ProofSource, EventType, Confidence, VerificationLevel } from './method';

export type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export function mapCase(r: Row): ProofCase {
  return {
    id: str(r.id), title: str(r.title), periodStart: str(r.period_start), periodEnd: str(r.period_end), currency: str(r.currency),
    costCents: r.cost_cents === null || r.cost_cents === undefined ? null : num(r.cost_cents), costBasis: str(r.cost_basis) as CostBasis,
    methodVersion: str(r.method_version), snapshotSha256: str(r.snapshot_sha256), verificationLevel: str(r.verification_level) as VerificationLevel,
    verifierName: strOrNull(r.verifier_name), verificationEvidenceUrl: strOrNull(r.verification_evidence_url), verifiedAt: strOrNull(r.verified_at),
  };
}
export function mapSource(r: Row): ProofSource {
  return {
    valueEventId: str(r.value_event_id), type: str(r.type) as EventType, amount: num(r.amount), unit: str(r.unit) === 'minutes' ? 'minutes' : 'cents',
    currency: strOrNull(r.currency), confidence: str(r.confidence) as Confidence, evidenceRef: str(r.evidence_ref), occurredMs: num(r.occurred_ms),
    included: r.included === true, exclusion: strOrNull(r.exclusion) as Exclusion | null,
  };
}
export function mapConsent(r: Row): ProofConsent {
  return {
    id: str(r.id), decision: r.decision === 'granted' ? 'granted' : 'revoked', allowBusinessName: r.allow_business_name === true,
    allowPersonName: r.allow_person_name === true, allowQuote: r.allow_quote === true, quoteText: strOrNull(r.quote_text),
    signerName: str(r.signer_name), signerRole: strOrNull(r.signer_role), consentTextVersion: str(r.consent_text_version),
    caseSha256: str(r.case_sha256), decidedAt: str(r.decided_at),
  };
}
