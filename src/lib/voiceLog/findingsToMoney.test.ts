import { describe, expect, it, vi } from 'vitest';

const analyze = vi.fn(async (i: unknown) => i);
vi.mock('@/lib/fieldEstimate', () => ({ FIELD_LIMITS: { notesChars: 2000 }, analyzeFieldEstimate: (i: unknown) => analyze(i) }));

import type { FieldEstimateResult } from '@/lib/fieldEstimate';
import { buildEstimateNotes, draftEstimateFromLog, financingPrecheck, summarizeDraft } from './findingsToMoney';
import { normalizeExtraction, type VoiceExtraction } from '../../../supabase/functions/_shared/voice-log/extract';

const ex = normalizeExtraction({
  transcript: 't', summary: 's', findings: [{ text: 'capacitor bad', severity: 'safety', confidence: 1 }],
  parts: [{ name: 'capacitor', quantity: 2, confidence: 1 }], time_minutes: 50, time_confidence: 1, customer_notes: ['call first'],
}) as VoiceExtraction;

describe('findings to money', () => {
  it('builds estimator notes from findings, parts, time and customer notes (safety tagged)', () => {
    const s = buildEstimateNotes(ex);
    expect(s).toMatch(/\[safety\] capacitor bad/);
    expect(s).toMatch(/2 x capacitor/);
    expect(s).toMatch(/50 minutes/);
    expect(s).toMatch(/call first/);
    expect(buildEstimateNotes(ex, 20)).toHaveLength(20);
  });
  it('sends notes only (no photos) to the existing estimator', async () => {
    await draftEstimateFromLog(ex, 'hvac');
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ photoPaths: [], trade: 'hvac' }));
  });
  it('rejects a log with too little detail before calling the AI', async () => {
    analyze.mockClear();
    const tiny = normalizeExtraction({ transcript: 'hi', findings: [], parts: [], customer_notes: [] }) as VoiceExtraction;
    await expect(draftEstimateFromLog(tiny)).rejects.toThrow('not_enough_detail');
    expect(analyze).not.toHaveBeenCalled();
  });
  it('summarises tiers, counts unverified lines and marks the recommended tier', () => {
    const r = {
      recommended_tier: 'better', safety_flags: ['gas'],
      tiers: [
        { tier: 'good', total_cents: 1000, line_items: [{ needs_review: false, source: 'price_book' }] },
        { tier: 'better', total_cents: 2500, line_items: [{ needs_review: false, source: 'price_book' }, { needs_review: true, source: 'ai_estimate' }, { needs_review: false, source: 'ai_estimate' }] },
      ],
    } as unknown as FieldEstimateResult;
    const s = summarizeDraft(r);
    expect(s.reviewLines).toBe(2);
    expect(s.hasUnverifiedPrices).toBe(true);
    expect(s.tiers[1].recommended).toBe(true);
    expect(s.tiers[0].reviewLines).toBe(0);
    expect(s.safetyFlags).toEqual(['gas']);
  });
  it('financing pre-check is eligibility only', () => {
    expect(financingPrecheck(20000, true, 20000).status).toBe('eligible');
    expect(financingPrecheck(19999, true, 20000).status).toBe('below_minimum');
    expect(financingPrecheck(99999, false, 20000).status).toBe('not_connected');
  });
});
