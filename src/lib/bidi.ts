/* bidi — isolation helpers for LTR tokens (phones, emails, IDs, times) inside RTL text. */

const LRI = '\u2066'; // left-to-right isolate
const FSI = '\u2068'; // first-strong isolate
const PDI = '\u2069'; // pop directional isolate

/** Force a token to render LTR without reordering the surrounding sentence. Use for strings passed into t() params. */
export const isolateLtr = (text: string): string => `${LRI}${text}${PDI}`;

/** Isolate user-generated text of unknown direction (names, notes) inside a sentence. */
export const isolateAuto = (text: string): string => `${FSI}${text}${PDI}`;

/** Remove isolate controls (e.g. before copy-to-clipboard or search matching). */
export const stripIsolates = (text: string): string => text.replace(/[\u2066-\u2069]/g, '');
