import { describe, expect, it } from 'vitest';
import { formatDelta, parseEvalResult, parseSynonymInput, validateDraft, type EntryDraft } from './tradeVocabModel';

const draft = (over: Partial<EntryDraft> = {}): EntryDraft => ({
  term: 'Contactor', category: 'part', synonymsText: 'relay, switch', pronunciationHint: '', boost: 1, ...over,
});

describe('parseSynonymInput', () => {
  it('splits on commas, semicolons and new lines and drops empties', () => {
    expect(parseSynonymInput('relay,  switch ;\n  contact   or ,,')).toEqual(['relay', 'switch', 'contact or']);
    expect(parseSynonymInput('')).toEqual([]);
  });
});

describe('validateDraft', () => {
  it('accepts a normal entry', () => {
    expect(validateDraft(draft(), 'en-US')).toBeNull();
  });
  it('rejects a bad dialect', () => {
    expect(validateDraft(draft(), 'english')).toMatch(/Dialect/);
    expect(validateDraft(draft(), 'EN-us')).toMatch(/Dialect/);
  });
  it('rejects short, long and sentence-like terms', () => {
    expect(validateDraft(draft({ term: 'x' }), 'en')).toMatch(/2 to 80/);
    expect(validateDraft(draft({ term: 'a'.repeat(81) }), 'en')).toMatch(/2 to 80/);
    expect(validateDraft(draft({ term: 'one two three four five six seven' }), 'en')).toMatch(/short phrase/);
  });
  it('rejects forbidden characters in term, synonyms and hint', () => {
    expect(validateDraft(draft({ term: '{{x}}' }), 'en')).toMatch(/not allowed/);
    expect(validateDraft(draft({ synonymsText: 'ok, <b>bad</b>' }), 'en')).toMatch(/not allowed/);
    expect(validateDraft(draft({ pronunciationHint: 'say "hi"' }), 'en')).toMatch(/not allowed/);
  });
  it('limits synonym count and length', () => {
    expect(validateDraft(draft({ synonymsText: Array.from({ length: 13 }, (_, i) => `s${i}`).join(',') }), 'en')).toMatch(/At most 12/);
    expect(validateDraft(draft({ synonymsText: 'x'.repeat(61) }), 'en')).toMatch(/60 characters/);
  });
});

describe('parseEvalResult', () => {
  const good = {
    n_calls: 40, n_ref_words: 5000, n_term_occurrences: 120, baseline_wer: 0.2, biased_wer: 0.18,
    baseline_term_recall: 0.6, biased_term_recall: 0.7,
  };
  it('accepts the script output shape, including null recall', () => {
    expect(parseEvalResult(JSON.stringify(good)).ok).toBe(true);
    expect(parseEvalResult(JSON.stringify({ ...good, baseline_term_recall: null, biased_term_recall: null })).ok).toBe(true);
  });
  it('rejects anything else with a specific message', () => {
    expect(parseEvalResult('nope')).toEqual({ ok: false, error: 'Not valid JSON. Paste the output of scripts/voice/trade-vocab-eval.mjs.' });
    expect(parseEvalResult('[]').ok).toBe(false);
    expect(parseEvalResult(JSON.stringify({ ...good, n_calls: 0 }))).toEqual({ ok: false, error: '"n_calls" must be a positive integer.' });
    expect(parseEvalResult(JSON.stringify({ ...good, biased_wer: -1 })).ok).toBe(false);
    expect(parseEvalResult(JSON.stringify({ ...good, biased_term_recall: 1.2 })).ok).toBe(false);
    expect(parseEvalResult(JSON.stringify({ ...good, n_term_occurrences: 1.5 })).ok).toBe(false);
  });
});

describe('formatDelta', () => {
  it('formats signed deltas and null', () => {
    expect(formatDelta(0.2, 0.18)).toBe('−0.0200');
    expect(formatDelta(0.2, 0.25)).toBe('+0.0500');
    expect(formatDelta(0.2, 0.2)).toBe('0.0000');
    expect(formatDelta(null, 0.2)).toBe('—');
  });
});
