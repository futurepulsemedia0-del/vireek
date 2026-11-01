// Pure text helpers shared by masks, paste handling and schemas.
// No React, no browser APIs: safe to import from edge functions too.

const DIGIT_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x0660, 0x0669], // Arabic-Indic
  [0x06f0, 0x06f9], // Extended Arabic-Indic (Persian)
  [0x0966, 0x096f], // Devanagari
  [0xff10, 0xff19], // Fullwidth
];

/** Converts Persian / Arabic-Indic / Devanagari / fullwidth digits to ASCII 0-9. */
export function toLatinDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    const block = DIGIT_BLOCKS.find(([lo, hi]) => cp >= lo && cp <= hi);
    out += block ? String(cp - block[0]) : ch;
  }
  return out;
}

/** Zero-width, bidi-control and BOM characters that sneak in through copy/paste. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, '');
}

/** NFKC + invisible-char removal + NBSP→space. Does NOT trim. */
export function cleanPasted(input: string): string {
  return stripInvisible(input.normalize('NFKC')).replace(/[\u00A0\u2007\u202F]/g, ' ');
}
