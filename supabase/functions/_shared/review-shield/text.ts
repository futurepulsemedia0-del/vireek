// supabase/functions/_shared/review-shield/text.ts
//
// Shared, dependency-free text helpers for Review Shield. Pure: no I/O, no clock.
// Runs unchanged in Deno (edge functions), Node (tests) and the browser (dashboard).

// Zero-width / bidi control characters are a classic way to dodge keyword filters.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Lower-case, NFKC-normalise, strip invisible characters, collapse whitespace. */
export function normalizeText(input: unknown): string {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Word tokens (letters/digits in any script). */
export function tokenize(input: unknown): string[] {
  return normalizeText(input).match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** Strip diacritics ("José" -> "jose") for name comparison only. */
export function foldDiacritics(input: string): string {
  return input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
