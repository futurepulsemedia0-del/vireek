/* ------------------------------------------------------------------ */
/*  textPolicy — one policy for long names, emails, addresses, notes   */
/*                                                                      */
/*  Rules (see docs/voice-and-tone.md → "Long text"):                   */
/*   1. Never let content widen its container: every flex/grid child    */
/*      that holds user text gets `min-w-0` (TEXT_CLASSES.cell).        */
/*   2. Names, emails, IDs → single line, ellipsis, full text in title. */
/*   3. Addresses → 2 lines. Notes → 3 lines + "Show more".             */
/*   4. Long unbroken tokens (URLs, IDs) always wrap (`break-words`).   */
/*  Pure module: no app imports.                                        */
/* ------------------------------------------------------------------ */

export type TextKind = 'name' | 'email' | 'address' | 'note' | 'id';

/** Max visible lines before truncation, per kind (note is expandable). */
export const TEXT_LINES: Record<TextKind, 1 | 2 | 3> = {
  name: 1,
  email: 1,
  id: 1,
  address: 2,
  note: 3,
};

/** Static class names so Tailwind can see them (never build these dynamically). */
export const LINE_CLAMP_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'truncate',
  2: 'line-clamp-2 break-words',
  3: 'line-clamp-3 break-words',
  4: 'line-clamp-4 break-words',
  5: 'line-clamp-5 break-words',
  6: 'line-clamp-6 break-words',
};

export const TEXT_CLASSES = {
  /** Put on any flex/grid child that contains user text. */
  cell: 'min-w-0',
  /** Free-form text that may contain long tokens (URLs, IDs). */
  wrap: 'min-w-0 break-words [overflow-wrap:anywhere]',
} as const;

type SegmenterCtor = new (
  locale?: string,
  options?: { granularity: 'grapheme' },
) => { segment(input: string): Iterable<{ segment: string }> };

function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  return Array.from(text);
}

/** Number of user-perceived characters (what truncateMiddle counts). */
export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/**
 * "averyveryverylongname@exampledomain.com" → "averyveryv…ain.com".
 * Keeps the end visible (domain / ID suffix). Counts user-perceived characters,
 * so emoji and Persian/Hindi combining marks are never split.
 */
export function truncateMiddle(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 3) return text;
  const chars = graphemes(text);
  if (chars.length <= max) return text;
  const tail = Math.min(Math.floor((max - 1) / 3), 12);
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

/* ---------------------- pseudo-localization ---------------------- */

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/**
 * Accents every letter and pads the string by `expansion` (default +40%) inside
 * [ ] brackets, leaving {{placeholders}} untouched. Used by tests and the
 * optional dev pseudo-locale to expose overflow and hard-coded strings.
 */
export function pseudoLocalize(text: string, expansion = 0.4): string {
  const parts = text.split(/(\{\{[^}]*\}\})/g);
  const body = parts
    .map((p) => (p.startsWith('{{') ? p : Array.from(p, (c) => ACCENTS[c] ?? c).join('')))
    .join('');
  const pad = '·'.repeat(Math.max(1, Math.ceil(Array.from(text).length * expansion)));
  return `[${body}${pad}]`;
}

/** Stress strings every list/table/card must survive (see textPolicy.test.ts). */
export const STRESS_STRINGS = {
  german: 'Donaudampfschifffahrtsgesellschaftskapitänsmützenhersteller-Betriebsvereinbarung',
  finnish: 'Lentokonesuihkuturbiinimoottoriapumekaanikkoaliupseerioppilas',
  persian: 'مهندس‌محمدرضا‌علی‌اکبری‌نژاد‌خراسانی‌پور‌شیرازی‌نمونه‌بسیارطولانی',
  twoHundred: 'A'.repeat(200),
  longEmail: `${'very.long.local.part.'.repeat(5)}@sub.domain.${'example'.repeat(6)}.com`,
  longUrl: `https://example.com/${'segment/'.repeat(30)}?token=${'x'.repeat(80)}`,
} as const;
