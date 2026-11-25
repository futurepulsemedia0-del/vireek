// Pure helpers for the trade vocabulary staff editor (no I/O, no React). Mirrors the limits enforced in
// supabase/migrations/20290312000000_trade_vocabulary.sql, which stays the authority.

export const VOCAB_TRADES = ['general', 'plumbing', 'hvac', 'electrical', 'roofing'] as const;
export const VOCAB_CATEGORIES = ['term', 'brand', 'model', 'part', 'slang'] as const;
export const DIALECT_SUGGESTIONS = ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU'] as const;

export type VocabTrade = (typeof VOCAB_TRADES)[number];
export type VocabCategory = (typeof VOCAB_CATEGORIES)[number];

export const DIALECT_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
export const MAX_SYNONYMS = 12;
export const MAX_WORDS = 6;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_RE = /[\u0000-\u001f\u007f{}<>`"\\]/;

export interface EntryDraft {
  term: string;
  category: VocabCategory;
  synonymsText: string;
  pronunciationHint: string;
  boost: 1 | 2 | 3;
}

/** Synonyms are typed separated by commas, semicolons or new lines. Empty items are dropped. */
export function parseSynonymInput(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Client-side pre-check so staff get a precise message; the database re-validates everything. Returns null when fine. */
export function validateDraft(d: EntryDraft, dialect: string): string | null {
  const term = d.term.replace(/\s+/g, ' ').trim();
  if (!DIALECT_RE.test(dialect)) return 'Dialect must look like "en" or "en-US".';
  if (term.length < 2 || term.length > 80) return 'Term must be 2 to 80 characters.';
  if (term.split(' ').length > MAX_WORDS) return `A term is a word or short phrase (at most ${MAX_WORDS} words).`;
  if (FORBIDDEN_RE.test(d.term)) return 'Term contains a character that is not allowed (control characters, quotes, braces, angle brackets, backslash).';
  const syn = parseSynonymInput(d.synonymsText);
  if (syn.length > MAX_SYNONYMS) return `At most ${MAX_SYNONYMS} synonyms.`;
  for (const s of syn) {
    if (s.length > 60) return `Synonym "${s.slice(0, 20)}…" is longer than 60 characters.`;
    if (s.split(' ').length > MAX_WORDS) return `Synonym "${s.slice(0, 20)}…" has more than ${MAX_WORDS} words.`;
    if (FORBIDDEN_RE.test(s)) return `Synonym "${s.slice(0, 20)}…" contains a character that is not allowed.`;
  }
  const hint = d.pronunciationHint.replace(/\s+/g, ' ').trim();
  if (hint.length > 120) return 'Pronunciation hint must be 120 characters or fewer.';
  if (hint && FORBIDDEN_RE.test(d.pronunciationHint)) return 'Pronunciation hint contains a character that is not allowed.';
  return null;
}

export interface EvalResult {
  n_calls: number;
  n_ref_words: number;
  n_term_occurrences: number;
  baseline_wer: number;
  biased_wer: number;
  baseline_term_recall: number | null;
  biased_term_recall: number | null;
}

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRecall = (v: unknown): v is number | null => v === null || (typeof v === 'number' && v >= 0 && v <= 1);

/** Validates the JSON printed by scripts/voice/trade-vocab-eval.mjs. Refuses anything that is not that shape. */
export function parseEvalResult(json: string): { ok: true; value: EvalResult } | { ok: false; error: string } {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Not valid JSON. Paste the output of scripts/voice/trade-vocab-eval.mjs.' };
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'Expected a JSON object.' };
  const r = o as Record<string, unknown>;
  if (!isPosInt(r.n_calls)) return { ok: false, error: '"n_calls" must be a positive integer.' };
  if (!isPosInt(r.n_ref_words)) return { ok: false, error: '"n_ref_words" must be a positive integer.' };
  if (!isNonNegInt(r.n_term_occurrences)) return { ok: false, error: '"n_term_occurrences" must be a non-negative integer.' };
  if (!isNonNeg(r.baseline_wer) || !isNonNeg(r.biased_wer)) return { ok: false, error: 'WER values must be numbers >= 0.' };
  if (!isRecall(r.baseline_term_recall) || !isRecall(r.biased_term_recall)) return { ok: false, error: 'Term recall must be null or a number between 0 and 1.' };
  return {
    ok: true,
    value: {
      n_calls: r.n_calls,
      n_ref_words: r.n_ref_words,
      n_term_occurrences: r.n_term_occurrences,
      baseline_wer: r.baseline_wer,
      biased_wer: r.biased_wer,
      baseline_term_recall: r.baseline_term_recall,
      biased_term_recall: r.biased_term_recall,
    },
  };
}

/** "−0.0312" style signed delta for display; null-safe. */
export function formatDelta(before: number | null, after: number | null, digits = 4): string {
  if (before === null || after === null) return '—';
  const d = after - before;
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(digits)}`;
}
