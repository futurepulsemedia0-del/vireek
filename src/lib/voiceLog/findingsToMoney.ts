// Findings -> money (phase D). Wraps the EXISTING field-estimate function (price-book grounded,
// draft-only, never writes, never contacts a customer) with the technician-approved voice log.
import { FIELD_LIMITS, analyzeFieldEstimate, type FieldEstimateResult } from '@/lib/fieldEstimate';
import type { VoiceExtraction } from '../../../supabase/functions/_shared/voice-log/extract';

/** Plain-text evidence for the estimator; built ONLY from content the technician approved. */
export function buildEstimateNotes(ex: VoiceExtraction, limit: number = FIELD_LIMITS.notesChars): string {
  const lines: string[] = [];
  if (ex.findings.length) lines.push('Technician findings:', ...ex.findings.map((f) => `- ${f.severity === 'safety' ? '[safety] ' : ''}${f.text}`));
  if (ex.parts.length) lines.push('Parts needed/used:', ...ex.parts.map((p) => `- ${p.quantity} x ${p.name}`));
  if (ex.time_minutes !== null) lines.push(`Time on job: ${ex.time_minutes} minutes`);
  if (ex.customer_notes.length) lines.push('Customer notes:', ...ex.customer_notes.map((n) => `- ${n}`));
  return lines.join('\n').slice(0, limit);
}

export async function draftEstimateFromLog(ex: VoiceExtraction, trade = ''): Promise<FieldEstimateResult> {
  const notes = buildEstimateNotes(ex);
  if (notes.replace(/\s/g, '').length < 10) throw new Error('not_enough_detail');
  return analyzeFieldEstimate({ photoPaths: [], notes, trade });
}

export interface TierSummary { tier: string; totalCents: number; reviewLines: number; recommended: boolean }
export interface DraftSummary { tiers: TierSummary[]; reviewLines: number; safetyFlags: string[]; hasUnverifiedPrices: boolean }

export function summarizeDraft(r: Pick<FieldEstimateResult, 'tiers' | 'recommended_tier' | 'safety_flags'>): DraftSummary {
  const tiers = r.tiers.map((t) => ({
    tier: t.tier,
    totalCents: t.total_cents,
    reviewLines: t.line_items.filter((l) => l.needs_review || l.source !== 'price_book').length,
    recommended: t.tier === r.recommended_tier,
  }));
  const reviewLines = tiers.reduce((n, t) => n + t.reviewLines, 0);
  return { tiers, reviewLines, safetyFlags: r.safety_flags, hasUnverifiedPrices: reviewLines > 0 };
}

export type FinancingStatus = 'eligible' | 'below_minimum' | 'not_connected';
export interface FinancingPrecheck { status: FinancingStatus; minCents: number }

/** Eligibility only. The monthly figure is shown separately as an indication, never as an offer. */
export function financingPrecheck(totalCents: number, connected: boolean, minCents: number): FinancingPrecheck {
  if (!connected) return { status: 'not_connected', minCents };
  return { status: totalCents >= minCents ? 'eligible' : 'below_minimum', minCents };
}
