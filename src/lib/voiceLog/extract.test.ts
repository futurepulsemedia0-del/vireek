import { describe, expect, it } from 'vitest';
import {
  AI_NOTE_PREFIX, buildJobNote, expectedAudioPath, normalizeExtraction, redactPii, UUID_RE,
} from '../../../supabase/functions/_shared/voice-log/extract';
import { backoffMs } from './queue';

describe('redactPii', () => {
  it('hides email, SSN, Luhn-valid cards and formatted phones', () => {
    const s = redactPii('a@b.com 123-45-6789 4111 1111 1111 1111 +34 612 345 678');
    expect(s).toBe('[email] [id] [card] [phone]');
  });
  it('keeps equipment serial numbers', () => {
    expect(redactPii('serial 1234567890 and 1234 5678 9012 3456')).toBe('serial 1234567890 and 1234 5678 9012 3456');
  });
});

describe('normalizeExtraction', () => {
  it('rejects garbage', () => {
    for (const v of [null, undefined, 'x', 3, {}, { findings: 'no' }]) expect(normalizeExtraction(v)).toBeNull();
  });
  it('clamps confidence, quantity and time; flags review', () => {
    const e = normalizeExtraction({
      transcript: 't', findings: [{ text: 'a', severity: 'weird', confidence: 9 }],
      parts: [{ name: 'relay', quantity: -2, confidence: 0.99 }], time_minutes: 99999, customer_notes: [],
    })!;
    expect(e.findings[0]).toMatchObject({ severity: 'info', confidence: 1 });
    expect(e.parts[0].quantity).toBe(1);
    expect(e.parts[0].confidence).toBeLessThanOrEqual(0.3);
    expect(e.time_minutes).toBeNull();
    expect(e.needs_review).toBe(true);
  });
  it('safety findings always need review', () => {
    expect(normalizeExtraction({ transcript: 't', findings: [{ text: 'co', severity: 'safety', confidence: 1 }], parts: [], customer_notes: [] })!.needs_review).toBe(true);
  });
  it('confident clean dictation does not need review', () => {
    expect(normalizeExtraction({ transcript: 't', findings: [{ text: 'filter', severity: 'minor', confidence: 0.9 }], parts: [], time_minutes: 30, time_confidence: 0.8, customer_notes: [] })!.needs_review).toBe(false);
  });
});

describe('buildJobNote', () => {
  it('is labelled as AI-assisted and includes approved content', () => {
    const e = normalizeExtraction({ transcript: 't', summary: 'Swapped cap', findings: [{ text: 'co', severity: 'safety', confidence: 1 }], parts: [{ name: 'cap', quantity: 2, confidence: 1 }], time_minutes: 45, time_confidence: 1, customer_notes: [] })!;
    const n = buildJobNote(e);
    expect(n.startsWith(AI_NOTE_PREFIX)).toBe(true);
    expect(n).toContain('[SAFETY] co');
    expect(n).toContain('2 × cap');
    expect(n).toContain('Time: 45 min');
  });
});

describe('path + queue helpers', () => {
  it('builds the per-user audio path and validates ids', () => {
    expect(expectedAudioPath('u', 'j', 'd', 'WEBM')).toBe('u/j/voice-log-d.webm');
    expect(UUID_RE.test(crypto.randomUUID())).toBe(true);
    expect(UUID_RE.test('../x')).toBe(false);
  });
  it('backs off exponentially, capped at 10 minutes', () => {
    expect(backoffMs(1)).toBe(15_000);
    expect(backoffMs(3)).toBe(60_000);
    expect(backoffMs(20)).toBe(600_000);
  });
});
