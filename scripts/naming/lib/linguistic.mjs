// Linguistic / phonetic screening heuristics. Pure functions, no I/O.
// These are COARSE heuristics written for screening only. They are not linguistic authority;
// a native-speaker review is part of the manual checklist.

export const LANGUAGES = Object.freeze({
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ar: 'Arabic',
  zh: 'Mandarin Chinese',
  ja: 'Japanese',
  hi: 'Hindi',
});
const CODES = Object.keys(LANGUAGES);

/** Penalty points (0-3) per language, in CODES order: en es fr de pt ar zh ja hi. */
const pen = (...v) => Object.fromEntries(CODES.map((c, i) => [c, v[i]]));

const HARD_RULES = [
  { id: 'th', re: /th/g, note: 'th (dental fricative) is missing in most languages', pen: pen(0, 3, 3, 3, 3, 2, 3, 3, 2) },
  { id: 'ph', re: /ph/g, note: 'ph may be read p+h instead of f', pen: pen(0, 1, 1, 1, 0, 1, 1, 1, 1) },
  { id: 'gh', re: /gh/g, note: 'gh is silent or irregular in English spelling', pen: pen(0, 2, 2, 2, 2, 2, 2, 2, 2) },
  { id: 'sch', re: /sch/g, note: 'sch is read differently (sk / sh / sch)', pen: pen(1, 1, 2, 1, 2, 2, 2, 2, 2) },
  { id: 'ch', re: /ch/g, note: 'ch is read differently (ch / sh / kh)', pen: pen(1, 1, 2, 2, 2, 2, 1, 1, 1) },
  { id: 'silent-initial', re: /^(kn|wr|gn|pn|ps)/g, note: 'silent initial letter in English', pen: pen(1, 2, 2, 1, 2, 2, 2, 2, 2) },
  { id: 'tch-dge', re: /tch|dge/g, note: 'tch / dge spellings are irregular outside English', pen: pen(0, 2, 2, 2, 2, 2, 2, 2, 2) },
  { id: 'q', re: /q/g, note: 'q is read k / kw / uvular depending on language', pen: pen(0, 1, 1, 1, 1, 3, 2, 2, 3) },
  { id: 'x', re: /x/g, note: 'x is read ks / sh / h / z depending on language', pen: pen(0, 1, 1, 1, 2, 2, 2, 1, 2) },
  { id: 'j', re: /j/g, note: 'j is read dj / y / zh / h depending on language', pen: pen(0, 2, 1, 2, 1, 0, 1, 1, 0) },
  { id: 'w', re: /w/g, note: 'w is read w / v / absent depending on language', pen: pen(0, 1, 1, 2, 1, 1, 0, 2, 2) },
  { id: 'v', re: /v/g, note: 'v merges with b/w/f or is absent in some languages', pen: pen(0, 2, 0, 1, 0, 3, 0, 1, 1) },
  { id: 'z', re: /z/g, note: 'z is read z / ts / th depending on language', pen: pen(0, 1, 0, 2, 1, 0, 2, 1, 1) },
  { id: 'h', re: /h/g, note: 'h is silent in several languages', pen: pen(0, 2, 2, 0, 2, 0, 1, 1, 0) },
  { id: 'c', re: /c/g, note: 'c is hard or soft (k / s / ts / ch)', pen: pen(0, 1, 1, 1, 1, 1, 2, 1, 1) },
  { id: 'y', re: /y/g, note: 'y is ambiguous between vowel and consonant', pen: pen(0, 1, 1, 1, 1, 1, 1, 1, 1) },
];

/** Both l and r present: Japanese (and some Mandarin speakers) may not distinguish them. */
const LR_PEN = pen(0, 0, 0, 0, 0, 0, 1, 2, 0);
/** Runs of 3+ consonants are difficult in languages with strict syllable structure. */
const CLUSTER_PEN = pen(0, 1, 0, 0, 1, 2, 2, 2, 2);

const PENALTY_UNIT = 7;
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const count = (s, re) => (s.match(re) || []).length;

/** V/C shape string. y counts as a vowel except before a vowel at the start of the name. */
export function vowelShape(name) {
  return [...name]
    .map((ch, i) => {
      if ('aeiou'.includes(ch)) return 'V';
      if (ch === 'y') return i === 0 && 'aeiou'.includes(name[1] ?? '') ? 'C' : 'V';
      return 'C';
    })
    .join('');
}

function runs(shape, name, kind) {
  const out = [];
  const re = new RegExp(`${kind}+`, 'g');
  for (let m = re.exec(shape); m; m = re.exec(shape)) {
    out.push({ length: m[0].length, text: name.slice(m.index, m.index + m[0].length) });
  }
  return out;
}

/** Language-neutral, English-leaning phonotactic score, 0-100 (higher = easier to say). */
export function pronounceability(name) {
  const shape = vowelShape(name);
  const issues = [];
  let score = 100;

  const vowels = count(shape, /V/g);
  if (vowels === 0) {
    score -= 60;
    issues.push('no vowels');
  }
  const ratio = vowels / name.length;
  if (vowels > 0 && ratio < 0.2) {
    score -= 15;
    issues.push(`very few vowels (${vowels}/${name.length})`);
  } else if (ratio > 0.7) {
    score -= 10;
    issues.push(`mostly vowels (${vowels}/${name.length})`);
  }
  for (const r of runs(shape, name, 'C')) {
    if (r.length >= 5) {
      score -= 45;
      issues.push(`${r.length}-consonant run "${r.text}"`);
    } else if (r.length === 4) {
      score -= 25;
      issues.push(`4-consonant run "${r.text}"`);
    } else if (r.length === 3) {
      score -= 10;
      issues.push(`3-consonant run "${r.text}"`);
    }
  }
  for (const r of runs(shape, name, 'V')) {
    if (r.length >= 4) {
      score -= 20;
      issues.push(`${r.length}-vowel run "${r.text}"`);
    } else if (r.length === 3) {
      score -= 10;
      issues.push(`3-vowel run "${r.text}"`);
    }
  }
  if (/(.)\1\1/.test(name)) {
    score -= 15;
    issues.push('letter repeated 3+ times');
  }
  const silent = count(name, HARD_RULES.find((r) => r.id === 'silent-initial').re);
  if (silent) {
    score -= 5;
    issues.push('silent initial letter (English)');
  }
  if (/(gh|tch|dge)/.test(name)) {
    score -= 5;
    issues.push('irregular English spelling (gh / tch / dge)');
  }
  return { score: clamp(score), issues, shape };
}

/** Per-language fit and the rules that fired (only rules with penalty >= 2 are reported). */
export function internationalFit(name) {
  const penalties = Object.fromEntries(CODES.map((c) => [c, 0]));
  const flags = [];
  const apply = (id, n, table, note) => {
    if (!n) return;
    for (const c of CODES) penalties[c] += Math.min(n, 2) * table[c];
    const langs = CODES.filter((c) => table[c] >= 2);
    if (langs.length) flags.push({ id, note, languages: langs.map((c) => LANGUAGES[c]) });
  };
  for (const rule of HARD_RULES) apply(rule.id, count(name, rule.re), rule.pen, rule.note);
  if (name.includes('l') && name.includes('r')) {
    apply('l+r', 1, LR_PEN, 'l and r together may be confused (Japanese; some Mandarin speakers)');
  }
  const clusters = runs(vowelShape(name), name, 'C').filter((r) => r.length >= 3).length;
  apply('consonant-cluster', clusters, CLUSTER_PEN, 'consonant clusters are hard in languages with strict syllables');

  const perLanguage = Object.fromEntries(
    CODES.map((c) => [c, clamp(100 - penalties[c] * PENALTY_UNIT)]),
  );
  const values = CODES.map((c) => perLanguage[c]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const worstCode = CODES.find((c) => perLanguage[c] === min);
  return {
    score: Math.round(0.7 * mean + 0.3 * min),
    perLanguage,
    worst: { code: worstCode, language: LANGUAGES[worstCode], score: min },
    flags,
  };
}

/** Validate and normalise an affix config ({prefixes, suffixes}). */
export function normalizeAffixConfig(raw) {
  const clean = (list) => [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .filter((s) => typeof s === 'string')
        .map((s) => s.toLowerCase().replace(/[^a-z]/g, ''))
        .filter((s) => s.length >= 2),
    ),
  ];
  return { prefixes: clean(raw?.prefixes), suffixes: clean(raw?.suffixes) };
}

/** Prefix / suffix saturation flags. Short affixes (<=2) need a stem of 3+ letters, others 2+. */
export function affixFlags(name, config) {
  const { prefixes, suffixes } = normalizeAffixConfig(config);
  const out = [];
  const check = (kind, list, test, stemOf) => {
    for (const affix of list) {
      if (name.length < affix.length || !test(name, affix)) continue;
      const stem = stemOf(name, affix);
      const minStem = affix.length <= 2 ? 3 : 2;
      if (stem.length === 0) out.push({ kind, affix, wholeName: true });
      else if (stem.length >= minStem) out.push({ kind, affix, wholeName: false });
    }
  };
  check('prefix', prefixes, (n, a) => n.startsWith(a), (n, a) => n.slice(a.length));
  check('suffix', suffixes, (n, a) => n.endsWith(a), (n, a) => n.slice(0, n.length - a.length));
  return out;
}

export function analyzeLinguistic(name, affixConfig) {
  return {
    name,
    length: name.length,
    pronounceability: pronounceability(name),
    internationalFit: internationalFit(name),
    affixes: affixFlags(name, affixConfig),
  };
}
