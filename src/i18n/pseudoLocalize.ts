/**
 * Pseudo-localization for dev/CI: accents (finds hard-coded strings), ~40% expansion
 * (finds truncation/overflow) and optional RTL mirroring. Pure; preserves {{placeholders}},
 * {icu, tokens} and <tags> so the UI keeps working.
 */
const ACCENTS: Readonly<Record<string, string>> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ô', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'À', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ô', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};
const RLO = '\u202E';
const PDF = '\u202C';
const TAG = /^<\/?[A-Za-z][^>]*>/;

/** End index (exclusive) of a brace-balanced {...} group starting at `start`, or -1 if unbalanced. */
function balancedEnd(str: string, start: number): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

export interface PseudoOptions {
  /** Extra length as a fraction of the original (default 0.4). */
  expansion?: number;
  /** Wrap in RLO..PDF to mimic right-to-left rendering. */
  rtl?: boolean;
}

export function pseudoLocalize(input: string, { expansion = 0.4, rtl = false }: PseudoOptions = {}): string {
  if (!input) return input;
  let visible = 0;
  let out = '';
  for (let i = 0; i < input.length; ) {
    const ch = input[i];
    if (ch === '{') {
      const end = balancedEnd(input, i);
      if (end !== -1) { out += input.slice(i, end); i = end; continue; }
    } else if (ch === '<') {
      const m = TAG.exec(input.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += ACCENTS[ch] ?? ch;
    if (/\S/.test(ch)) visible++;
    i++;
  }
  const pad = Math.ceil(visible * Math.max(0, expansion));
  if (pad > 0) out += ` ${'~'.repeat(pad)}`;
  const wrapped = `[${out}]`;
  return rtl ? `${RLO}${wrapped}${PDF}` : wrapped;
}

/** Deep-map a nested resource object (arrays and non-strings are kept as is). */
export function pseudoLocalizeResource<T>(res: T, opts?: PseudoOptions): T {
  if (typeof res === 'string') return pseudoLocalize(res, opts) as unknown as T;
  if (Array.isArray(res)) return res.map((x) => pseudoLocalizeResource(x, opts)) as unknown as T;
  if (res && typeof res === 'object') {
    return Object.fromEntries(Object.entries(res).map(([k, v]) => [k, pseudoLocalizeResource(v, opts)])) as T;
  }
  return res;
}
